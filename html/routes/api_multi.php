<?php

require_once webroot_fs_path('/../app/Helpers/common_functions.php');

use App\Controllers\BaseController;
use App\Services\AuthService;
use App\Helpers\ResponseHelper;

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

switch ($path) {
    case '/api/health':
        ResponseHelper::json(['status' => 'ok']);
        break;

    case '/api/login':
        // đọc body JSON
        $input = json_decode(file_get_contents('php://input'), true);
        $username = $input['username'] ?? null;
        $password = $input['password'] ?? null;

        if (!$username || !$password) {
            http_response_code(400);
            ResponseHelper::json(['error' => 'Missing username or password']);
            break;
        }

        $auth = new AuthService();
        $user = $auth->verifyCredentials($username, $password);

        if ($user) {
            // Sinh Signal JWT có chứa user_id / identity
            $jwt = $auth->generateSignalToken([
                'user_id'  => $user['id'],
                'username' => $user['username']
            ]);
            ResponseHelper::json(['signal_jwt' => $jwt]);
        } else {
            http_response_code(401);
            ResponseHelper::json(['error' => 'Invalid credentials']);
        }
        break;

    case '/api/rooms/create':
        $auth = new AuthService();

        // Lấy Authorization header
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization'] 
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        if (!preg_match('/Bearer\s+(\S+)/i', $authHeader, $m)) {
            http_response_code(401);
            ResponseHelper::json(['error' => 'Missing or invalid Authorization header']);
            break;
        }
        $signalJwt = $m[1];

        try {
            // Giải mã Signal JWT
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode(
                $signalJwt, 
                new \Firebase\JWT\Key($jwtSecret, 'HS256')
            );

            $userId   = $decoded->user_id ?? null;
            $username = $decoded->username ?? 'guest';

            if (!$userId) {
                throw new \Exception('Invalid JWT: missing user_id');
            }

            // Sinh room_id (UUID v4)
            $roomId = sprintf(
                '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
                mt_rand(0, 0xffff), mt_rand(0, 0xffff),
                mt_rand(0, 0xffff),
                mt_rand(0, 0x0fff) | 0x4000,
                mt_rand(0, 0x3fff) | 0x8000,
                mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
            );

            // (Tùy chọn) lưu vào DB: rooms table với owner_id, created_at

            ResponseHelper::json([
                'room_id'    => $roomId,
                'owner'      => [
                    'id'       => $userId,
                    'username' => $username
                ],
                'created_at' => date('c')
            ]);

        } catch (\Throwable $e) {
            http_response_code(401);
            ResponseHelper::json([
                'error'   => 'Invalid or expired Signal JWT',
                'message' => $e->getMessage(),
            ]);
        }
        break;

    case '/api/token/livekit':
        $auth = new AuthService();

        // Body JSON: { "room": "demo" }
        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $room = isset($body['room']) && is_string($body['room']) ? trim($body['room']) : 'demo';
        // Multi-device support: identity unique theo device/tab
        $deviceId  = isset($body['device_id']) && is_string($body['device_id']) ? trim($body['device_id']) : '';
        $sessionId = isset($body['session_id']) && is_string($body['session_id']) ? trim($body['session_id']) : '';

        // sanitize nhẹ để tránh ký tự lạ đi vào identity/metadata
        $deviceId  = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $deviceId);
        $sessionId = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $sessionId);

        if ($deviceId === '')  { $deviceId  = bin2hex(random_bytes(8)); }
        if ($sessionId === '') { $sessionId = bin2hex(random_bytes(8)); }


        // Lấy Authorization header (robust, hỗ trợ lowercase & server khác nhau)
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization'] 
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        if (!preg_match('/Bearer\s+(\S+)/i', $authHeader, $m)) {
            http_response_code(401);
            ResponseHelper::json(['error' => 'Missing or invalid Authorization header']);
            break;
        }
        $signalJwt = $m[1];

        try {
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode($signalJwt, new \Firebase\JWT\Key($jwtSecret, 'HS256'));

            $userId   = isset($decoded->user_id) ? (int)$decoded->user_id : null;
            $username = isset($decoded->username) && $decoded->username ? (string)$decoded->username : 'guest';

            if (!$userId) {
                throw new \Exception('Invalid JWT: missing user_id');
            }

            // Sinh LiveKit JWT cho đúng user + room
            // Sinh LiveKit JWT cho đúng user + room (multi-device safe)
            $identity = 'u' . $userId . '_' . substr(hash('sha256', $deviceId . '|' . $sessionId), 0, 16);
            $metadata = json_encode([
                'user_id'    => $userId,
                'username'   => $username,
                'device_id'  => $deviceId,
                'session_id' => $sessionId,
            ], JSON_UNESCAPED_SLASHES);

            $livekitJwt = $auth->generateLivekitToken([
                'user_id'  => $userId,
                'username' => $username,
                'room'     => $room,

                'identity' => $identity,
                'name'     => $username,
                'metadata' => $metadata,
            ]);

            // TURN credentials động (ICE fallback)
            $turnSecret   = $_ENV['TURN_SECRET'] ?? 'changeme';
            $ttl          = 3600; // 1 giờ
            $turnUsername = (time() + $ttl) . ':user' . $userId;
            $turnPassword = base64_encode(hash_hmac('sha1', $turnUsername, $turnSecret, true));

            $iceServers = [
                [ 'urls' => ['stun:stun.l.google.com:19302'] ],
                [
                    'urls'       => [
                        'turns:turn.shieldrtc.com:5349?transport=udp',
                        'turns:turn.shieldrtc.com:5349?transport=tcp',
                    ],
                    'username'   => $turnUsername,
                    'credential' => $turnPassword,
                ],
            ];

            // URL LiveKit signaling (bắt buộc phải có)
            $livekitUrl = trim((string)($_ENV['LIVEKIT_URL'] ?? ''));
            if ($livekitUrl === '') {
                http_response_code(500);
                ResponseHelper::json(['error' => 'LIVEKIT_URL is not configured']);
                break;
            }

            ResponseHelper::json([
                'livekit_url' => $livekitUrl,
                'livekit_jwt' => $livekitJwt,
                'ice_servers' => $iceServers,
                // exp của TURN creds (tham khảo cho client set timer refresh)
                'exp' => time() + $ttl,
                'user' => [
                    'id'       => $userId,
                    'username' => $username,
                ],
            ]);
        } catch (\Throwable $e) {
            http_response_code(401);
            ResponseHelper::json([
                'error'   => 'Invalid or expired Signal JWT',
                'message' => $e->getMessage(),
            ]);
        }
        break;

    case '/api/rooms/end':
        $auth = new AuthService();

        // --- Auth (optional nhưng nên có)
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization']
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        if (!preg_match('/Bearer\s+(\S+)/i', $authHeader, $m)) {
            error_log("Error not found auth header");
            http_response_code(401);
            ResponseHelper::json(['error' => 'Missing or invalid Authorization header']);
            break;
        }
        $signalJwt = $m[1];

        try {
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode(
                $signalJwt,
                new \Firebase\JWT\Key($jwtSecret, 'HS256')
            );

            $userId = $decoded->user_id ?? null;
            if (!$userId) {
                throw new \Exception('Invalid JWT');
            }

            // body chỉ để audit
            $body = json_decode(file_get_contents('php://input'), true) ?? [];
            $roomId = $body['room_id'] ?? null;

            // (optional) log việc user rời phòng
            // RoomsRepo::logLeave($roomId, $userId);

            ResponseHelper::json([
                'status'  => 'left_room',
                'room_id' => $roomId,
                'user_id' => $userId,
                'at'      => date('c'),
            ]);

        } catch (\Throwable $e) {
            logError('rooms.end', $e, [
                'user_id' => $userId ?? null,
                'room_id' => $roomId ?? null,
            ]);

            http_response_code(403);
            ResponseHelper::json([
                'error'   => 'End room failed',
                'message' => $e->getMessage(),
            ]);
        }
        break;

    case '/api/rooms/disband':
        $auth = new AuthService();

        // --- Lấy Authorization header (giống các nhánh khác)
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization']
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        if (!preg_match('/Bearer\s+(\S+)/i', $authHeader, $m)) {
            http_response_code(401);
            ResponseHelper::json(['error' => 'Missing or invalid Authorization header']);
            break;
        }
        $signalJwt = $m[1];

        try {
            // --- Decode Signal JWT
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode(
                $signalJwt,
                new \Firebase\JWT\Key($jwtSecret, 'HS256')
            );

            $userId = $decoded->user_id ?? null;
            if (!$userId) {
                throw new \Exception('Invalid JWT: missing user_id');
            }

            // --- Input
            $body = json_decode(file_get_contents('php://input'), true) ?? [];
            $roomId = $body['room_id'] ?? null;
            if (!$roomId) {
                throw new \Exception('Missing room_id');
            }

            // --- Kiểm tra quyền HOST / OWNER
            $room = RoomsRepo::getRoomById($roomId);
            if (!$room) {
                http_response_code(404);
                ResponseHelper::json(['error' => 'Room not found']);
                break;
            }

            if ((int)$room['owner_id'] !== (int)$userId) {
                http_response_code(403);
                ResponseHelper::json(['error' => 'Only room owner can disband this room']);
                break;
            }

            // --- Gọi LiveKit DeleteRoom (hard destroy)
            $serverJwt = $auth->generateServerApiToken(60);
            $deleteUrl = rtrim($_ENV['LIVEKIT_HTTP_URL'], '/')
                . '/twirp/livekit.RoomService/DeleteRoom';

            $ch = curl_init($deleteUrl);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_HTTPHEADER     => [
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $serverJwt,
                ],
                CURLOPT_POSTFIELDS     => json_encode(['room' => $roomId]),
                CURLOPT_RETURNTRANSFER => true,
            ]);

            $resp = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($httpCode >= 200 && $httpCode < 300) {
                // (Tuỳ chọn) đánh dấu room đã bị disband trong DB
                // RoomsRepo::markDisbanded($roomId, $userId);

                ResponseHelper::json([
                    'status'   => 'room_disbanded',
                    'room_id'  => $roomId,
                    'by_user'  => $userId,
                    'datetime' => date('c'),
                ]);
            } else {
                http_response_code(500);
                ResponseHelper::json([
                    'error'  => 'LiveKit DeleteRoom failed',
                    'detail' => $resp,
                ]);
            }

        } catch (\Throwable $e) {
            http_response_code(403);
            ResponseHelper::json([
                'error'   => 'Disband room failed',
                'message' => $e->getMessage(),
            ]);
        }
        break;

    default:
        http_response_code(404);
        ResponseHelper::json(['error' => 'Not found']);
}
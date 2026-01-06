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
        // --- Ensure PHP session is started (so $_SESSION works)
        if (session_status() !== PHP_SESSION_ACTIVE) {
            $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

            session_set_cookie_params([
                'lifetime' => 0,
                'path'     => '/',
                'domain'   => '',
                'secure'   => $isHttps,
                'httponly' => true,
                'samesite' => 'Lax', // nếu FE ở domain khác -> 'None' + secure=true
            ]);

            ini_set('session.use_strict_mode', '1');
            ini_set('session.use_only_cookies', '1');

            session_start();
        }

        // đọc body JSON
        $input = json_decode(file_get_contents('php://input'), true) ?? [];
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

            // ---- Multi-device / multi-tab identifiers (client nên gửi lên) ----
            $deviceId  = isset($input['device_id']) && is_string($input['device_id']) ? trim($input['device_id']) : '';
            $sessionId = isset($input['session_id']) && is_string($input['session_id']) ? trim($input['session_id']) : '';

            // sanitize nhẹ để tránh ký tự lạ
            $deviceId  = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $deviceId);
            $sessionId = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $sessionId);

            // device_id: ưu tiên giữ ổn định theo browser/device
            if ($deviceId === '') {
                $deviceId = $_SESSION['auth']['device_id'] ?? '';
            }
            if ($deviceId === '') {
                $deviceId = bin2hex(random_bytes(16));
            }

            // session_id: per-tab (sessionStorage). Nếu client không gửi thì tạo 1 cái.
            if ($sessionId === '') {
                $sessionId = bin2hex(random_bytes(16));
            }

            // chống session fixation (chỉ làm sau khi login OK)
            session_regenerate_id(true);

            // ---- Sinh Signal JWT ----
            $jwt = $auth->generateSignalToken([
                'user_id'  => $user['id'],
                'username' => $user['username'],
            ]);

            // (tuỳ chọn) prune tab_sessions để tránh phình vô hạn
            $tabSessions = $_SESSION['auth']['tab_sessions'] ?? [];
            if (is_array($tabSessions)) {
                $now = time();
                foreach ($tabSessions as $k => $t) {
                    if (!is_numeric($t) || ($now - (int)$t) > 86400 * 7) { // giữ 7 ngày
                        unset($tabSessions[$k]);
                    }
                }
                if (count($tabSessions) > 50) { // chặn số lượng tab quá nhiều
                    asort($tabSessions); // cũ lên đầu
                    $tabSessions = array_slice($tabSessions, -50, null, true);
                }
            } else {
                $tabSessions = [];
            }

            // ---- Lưu session (per browser session) ----
            $_SESSION['auth'] = [
                'user_id'    => (int)$user['id'],
                'username'   => (string)$user['username'],
                'signal_jwt' => (string)$jwt,

                'device_id'  => (string)$deviceId,

                // multi-tab: lưu dạng set, không overwrite giữa các tab
                'tab_sessions' => array_replace(
                    $tabSessions,
                    [ (string)$sessionId => time() ]
                ),

                'login_at'   => time(),
            ];

            // CSRF token (nếu sau này bạn gọi API kiểu cookie-based)
            if (empty($_SESSION['auth']['csrf'])) {
                $_SESSION['auth']['csrf'] = bin2hex(random_bytes(16));
            }

            ResponseHelper::json([
                'signal_jwt' => $jwt,
                'user' => [
                    'id'       => (int)$user['id'],
                    'username' => (string)$user['username'],
                ],
                'device_id'  => $deviceId,
                'session_id' => $sessionId,
                'csrf'       => $_SESSION['auth']['csrf'],
            ]);

        } else {
            http_response_code(401);
            ResponseHelper::json(['error' => 'Invalid credentials']);
        }

        break;

    case '/api/logout':
        // --- Ensure session started ---
        if (session_status() !== PHP_SESSION_ACTIVE) {
            $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

            session_set_cookie_params([
                'lifetime' => 0,
                'path'     => '/',
                'domain'   => '',
                'secure'   => $isHttps,
                'httponly' => true,
                'samesite' => 'Lax', // nếu cross-site -> 'None' + secure=true
            ]);

            ini_set('session.use_strict_mode', '1');
            ini_set('session.use_only_cookies', '1');

            session_start();
        }

        // --- Optional: audit info before wipe ---
        $userId  = $_SESSION['auth']['user_id'] ?? null;
        $roomId  = null;
        $body    = json_decode(file_get_contents('php://input'), true) ?? [];
        if (isset($body['room_id'])) {
            $roomId = $body['room_id'];
        }

        // --- Wipe session data ---
        $_SESSION = [];

        // --- Remove session cookie ---
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();

            // NOTE: setcookie signature differs across PHP versions; this is PHP 7.3+
            setcookie(session_name(), '', [
                'expires'  => time() - 42000,
                'path'     => $p['path'] ?? '/',
                'domain'   => $p['domain'] ?? '',
                'secure'   => $p['secure'] ?? false,
                'httponly' => $p['httponly'] ?? true,
                'samesite' => $p['samesite'] ?? 'Lax',
            ]);
        }

        session_destroy();

        ResponseHelper::json([
            'status'  => 'ok',
            'user_id' => $userId,
            'room_id' => $roomId,
            'at'      => date('c'),
        ]);
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

            $userId   = isset($decoded->user_id) ? (int)$decoded->user_id : null;
            $username = isset($decoded->username) && $decoded->username ? (string)$decoded->username : 'guest';

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

            // --- DB: persist room + audit create ---
            try {
                /** @var \App\Helpers\DbHelper $db */
                $db = require webroot_fs_path('/../app/Bootstrap/database.php');

                // test nhẹ (optional nhưng hữu ích)
                $ok = $db->selectSingleValue('SELECT 1');
                if ($ok !== '1' && $ok !== 1) {
                    throw new \Exception('Unexpected DB test result');
                }

                $roomsRepo = new \App\Repositories\RoomsRepo($db);
                $roomsRepo->createRoom($roomId, $userId);

            } catch (\Throwable $dbEx) {
                // Nếu bạn muốn: vẫn cho tạo phòng dù DB fail? => hiện tại mình chọn FAIL FAST
                error_log('Error creating room in DB: ' . $dbEx->getMessage());
                http_response_code(500);
                ResponseHelper::json([
                    'error'   => 'DB_ERROR',
                    'message' => 'Failed to create room in DB',
                ]);
                break;
            }

            ResponseHelper::json([
                'room_id'    => $roomId,
                'owner'      => [
                    'id'       => $userId,
                    'username' => $username
                ],
                'is_host'    => true,
                'created_at' => date('c'),
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

        // --- Ensure session started (để sync multi-tab / device) ---
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_start();
        }

        // Body JSON: { "room": "demo", "device_id": "...", "session_id": "..." }
        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $room = isset($body['room']) && is_string($body['room']) ? trim($body['room']) : 'demo';

        // Lấy Authorization header (robust, hỗ trợ lowercase & server khác nhau)
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization']
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        $signalJwt = null;

        if (preg_match('/Bearer\s+(\S+)/i', (string)$authHeader, $m)) {
            $signalJwt = $m[1];
        }

        $allowGuest = (int)($_ENV['ALLOW_GUEST'] ?? 0) === 1;

        if (!$signalJwt) {
            if ($allowGuest) {
                http_response_code(501);
                ResponseHelper::json([
                    'error'   => 'GUEST_NOT_IMPLEMENTED',
                    'message' => 'Guest access is enabled but not implemented yet.',
                ]);
                break;
            }

            http_response_code(401);
            ResponseHelper::json([
                'error'   => 'LOGIN_REQUIRED',
                'message' => 'Please login first',
            ]);
            break;
        }

        try {
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode($signalJwt, new \Firebase\JWT\Key($jwtSecret, 'HS256'));

            $userId   = isset($decoded->user_id) ? (int)$decoded->user_id : null;
            $username = isset($decoded->username) && $decoded->username ? (string)$decoded->username : 'guest';

            if (!$userId) {
                throw new \Exception('Invalid JWT: missing user_id');
            }

            // --- Require logged-in session (hard requirement for now) ---
            $sess = $_SESSION['auth'] ?? null;
            if (!is_array($sess) || empty($sess['user_id']) || empty($sess['signal_jwt'])) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'LOGIN_REQUIRED',
                    'message' => 'Session not found. Please login again.',
                ]);
                break;
            }

            // Must match user_id in session
            if ((int)$sess['user_id'] !== (int)$userId) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'SESSION_MISMATCH',
                    'message' => 'Session user mismatch. Please login again.',
                ]);
                break;
            }

            // Must match the exact token in session (so logout kills reuse)
            if (!hash_equals((string)$sess['signal_jwt'], (string)$signalJwt)) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'TOKEN_MISMATCH',
                    'message' => 'Token does not match current session. Please login again.',
                ]);
                break;
            }

            // =====================================================
            // Room status gate: block disbanded rooms from re-join
            // =====================================================
            $roomRow = null;

            try {
                /** @var \App\Helpers\DbHelper $db */
                $db = require webroot_fs_path('/../app/Bootstrap/database.php');

                $repo = new \App\Repositories\RoomsRepo($db);

                $roomRow = $repo->getRoomById($room);
                if (!$roomRow) {
                    http_response_code(404);
                    ResponseHelper::json([
                        'error'   => 'ROOM_NOT_FOUND',
                        'message' => 'Room does not exist',
                    ]);
                    break;
                }

                $status = $roomRow['status'] ?? 'active';

                if ($status === 'disbanded') {
                    // 410 Gone = đã bị huỷ vĩnh viễn
                    http_response_code(410);
                    ResponseHelper::json([
                        'error'   => 'ROOM_DISBANDED',
                        'message' => 'This room was disbanded',
                    ]);
                    break;
                }

                if ($status !== 'active') {
                    // ended/disbanded/unknown -> không cho join
                    http_response_code(409);
                    ResponseHelper::json([
                        'error'   => 'ROOM_NOT_ACTIVE',
                        'message' => 'Room is not active',
                    ]);
                    break;
                }

            } catch (\Throwable $e) {
                error_log('room_status_check_failed: ' . $e->getMessage());
                http_response_code(500);
                ResponseHelper::json([
                    'error'   => 'DB_ERROR',
                    'message' => 'Failed to verify room status',
                ]);
                break;
            }

            // is_host dùng luôn roomRow (đỡ query DB lần 2)
            $isHost = ((int)$roomRow['owner_id'] === (int)$userId);

            // Multi-device support: identity unique theo device/tab
            $deviceId  = isset($body['device_id']) && is_string($body['device_id']) ? trim($body['device_id']) : '';
            $sessionId = isset($body['session_id']) && is_string($body['session_id']) ? trim($body['session_id']) : '';

            // sanitize nhẹ để tránh ký tự lạ đi vào identity/metadata
            $deviceId  = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $deviceId);
            $sessionId = preg_replace('/[^a-zA-Z0-9_\-:.]/', '', $sessionId);

            // device_id: ưu tiên ổn định theo session -> nếu chưa có thì lấy từ body -> cuối cùng mới random
            $deviceIdSess = $_SESSION['auth']['device_id'] ?? '';
            if ($deviceIdSess !== '') {
                $deviceId = $deviceIdSess; // force ổn định
            } else if ($deviceId !== '') {
                // dùng device_id client gửi (ví dụ localStorage)
                // giữ nguyên $deviceId
            } else {
                $deviceId = bin2hex(random_bytes(16));
            }

            // session_id: per-tab (client nên lưu sessionStorage). Nếu thiếu thì tạo 1 cái.
            if ($sessionId === '') {
                $sessionId = bin2hex(random_bytes(16));
            }

            $_SESSION['auth']['user_id']    = $userId;
            $_SESSION['auth']['username']   = $username;
            $_SESSION['auth']['signal_jwt'] = (string)$signalJwt;
            $_SESSION['auth']['device_id']  = (string)$deviceId;

            // update last-seen cho tab session
            $tabSessions = $_SESSION['auth']['tab_sessions'] ?? [];
            if (!is_array($tabSessions)) {
                $tabSessions = [];
            }
            $tabSessions[(string)$sessionId] = time();

            // prune để tránh phình vô hạn
            $now = time();
            foreach ($tabSessions as $k => $t) {
                if (!is_numeric($t) || ($now - (int)$t) > 86400 * 7) { // giữ 7 ngày
                    unset($tabSessions[$k]);
                }
            }
            if (count($tabSessions) > 50) {
                asort($tabSessions); // cũ lên đầu
                $tabSessions = array_slice($tabSessions, -50, null, true);
            }

            $_SESSION['auth']['tab_sessions'] = $tabSessions;

            // --- LiveKit identity/metadata ---
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
                'exp'         => time() + $ttl,
                'user' => [
                    'id'       => $userId,
                    'username' => $username,
                ],

                // trả lại để client “đóng đinh”
                'device_id'  => $deviceId,
                'session_id' => $sessionId,
                'is_host'    => $isHost
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

        // --- Ensure session started (để chặn reuse token sau logout) ---
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_start();
        }

        // --- Lấy Authorization header ---
        $headers = function_exists('getallheaders') ? getallheaders() : [];
        $authHeader = $headers['Authorization']
            ?? ($headers['authorization'] ?? ($_SERVER['HTTP_AUTHORIZATION'] ?? ''));

        if (!preg_match('/Bearer\s+(\S+)/i', (string)$authHeader, $m)) {
            http_response_code(401);
            ResponseHelper::json([
                'error' => 'MISSING_AUTH',
                'message' => 'Missing or invalid Authorization header',
            ]);
            break;
        }
        $signalJwt = $m[1];

        // --- Input ---
        $body = json_decode(file_get_contents('php://input'), true) ?? [];
        $roomId = isset($body['room_id']) ? trim((string)$body['room_id']) : '';
        if ($roomId === '') {
            http_response_code(400);
            ResponseHelper::json([
                'error' => 'MISSING_ROOM_ID',
                'message' => 'Missing room_id',
            ]);
            break;
        }

        try {
            // --- Decode Signal JWT ---
            $jwtSecret = $_ENV['JWT_SECRET'] ?? 'changeme';
            $decoded = \Firebase\JWT\JWT::decode(
                $signalJwt,
                new \Firebase\JWT\Key($jwtSecret, 'HS256')
            );

            $userId = isset($decoded->user_id) ? (int)$decoded->user_id : 0;
            if ($userId <= 0) {
                throw new \Exception('Invalid JWT: missing user_id');
            }

            // --- Require logged-in session (giống /api/token/livekit) ---
            $sess = $_SESSION['auth'] ?? null;
            if (!is_array($sess) || empty($sess['user_id']) || empty($sess['signal_jwt'])) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'LOGIN_REQUIRED',
                    'message' => 'Session not found. Please login again.',
                ]);
                break;
            }

            if ((int)$sess['user_id'] !== (int)$userId) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'SESSION_MISMATCH',
                    'message' => 'Session user mismatch. Please login again.',
                ]);
                break;
            }

            if (!hash_equals((string)$sess['signal_jwt'], (string)$signalJwt)) {
                http_response_code(401);
                ResponseHelper::json([
                    'error' => 'TOKEN_MISMATCH',
                    'message' => 'Token does not match current session. Please login again.',
                ]);
                break;
            }

            // --- DB: load room + check owner ---
            /** @var \App\Helpers\DbHelper $db */
            $db = require webroot_fs_path('/../app/Bootstrap/database.php');
            $roomsRepo = new \App\Repositories\RoomsRepo($db);

            $room = $roomsRepo->getRoomById($roomId);
            if (!$room) {
                http_response_code(404);
                ResponseHelper::json([
                    'error' => 'ROOM_NOT_FOUND',
                    'message' => 'Room not found',
                ]);
                break;
            }

            // Nếu đã disband thì idempotent trả OK luôn (tuỳ bạn)
            if (($room['status'] ?? '') === 'disbanded') {
                ResponseHelper::json([
                    'status'   => 'room_disbanded',
                    'room_id'  => $roomId,
                    'by_user'  => $userId,
                    'datetime' => date('c'),
                    'note'     => 'already_disbanded',
                ]);
                break;
            }

            if ((int)$room['owner_id'] !== (int)$userId) {
                http_response_code(403);
                ResponseHelper::json([
                    'error' => 'FORBIDDEN',
                    'message' => 'Only room owner can disband this room',
                ]);
                break;
            }

            // --- Call LiveKit DeleteRoom (hard destroy) ---
            $livekitHttp = trim((string)($_ENV['LIVEKIT_HTTP_URL'] ?? ''));
            if ($livekitHttp === '') {
                http_response_code(500);
                ResponseHelper::json([
                    'error' => 'LIVEKIT_HTTP_URL_NOT_CONFIGURED',
                    'message' => 'LIVEKIT_HTTP_URL is not configured',
                ]);
                break;
            }

            $serverJwt = $auth->generateServerApiToken(60);
            $deleteUrl = rtrim($livekitHttp, '/') . '/twirp/livekit.RoomService/DeleteRoom';

            $ch = curl_init($deleteUrl);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_HTTPHEADER     => [
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $serverJwt,
                ],
                CURLOPT_POSTFIELDS     => json_encode(['room' => $roomId], JSON_UNESCAPED_SLASHES),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 10,
            ]);

            $resp = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);

            if ($resp === false) {
                http_response_code(502);
                ResponseHelper::json([
                    'error' => 'LIVEKIT_REQUEST_FAILED',
                    'message' => $curlErr ?: 'LiveKit request failed',
                ]);
                break;
            }

            if (($httpCode < 200 || $httpCode >= 300) && $httpCode !== 404) {
                # 404 is acceptable: room not found on LiveKit server
                http_response_code(502);
                ResponseHelper::json([
                    'error'  => 'LIVEKIT_DELETE_FAILED',
                    'message' => 'LiveKit DeleteRoom failed',
                    'detail' => $resp,
                    'http_code' => $httpCode,
                ]);
                break;
            }

            // --- DB: mark disbanded + audit ---
            $roomsRepo->markDisbanded($roomId, $userId);

            ResponseHelper::json([
                'status'   => 'room_disbanded',
                'room_id'  => $roomId,
                'by_user'  => $userId,
                'datetime' => date('c'),
            ]);

        } catch (\Throwable $e) {
            // JWT expired / invalid / decode errors -> 401
            http_response_code(401);
            ResponseHelper::json([
                'error'   => 'Invalid or expired Signal JWT',
                'message' => $e->getMessage(),
            ]);
        }
        break;

    default:
        http_response_code(404);
        ResponseHelper::json(['error' => 'Not found']);
}
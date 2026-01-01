<?php
namespace App\Services;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Monolog\Logger;
use Monolog\Handler\StreamHandler;

class AuthService
{
    private string $secret;
    private string $livekitKey;
    private string $livekitSecret;

    protected $log;

    public function __construct()
    {
        $this->log = new Logger('auth_service');
        $this->log->pushHandler(new StreamHandler('/var/www/html/storage/logs/auth_service.log', Logger::INFO));

        $this->secret = $_ENV['JWT_SECRET'] ?? 'changeme';
        $this->livekitKey = $_ENV['LIVEKIT_API_KEY'] ?? 'key';
        $this->livekitSecret = $_ENV['LIVEKIT_API_SECRET'] ?? 'secret';

        $this->log->info('livekit key: ' . $this->livekitKey);
        $this->log->info('livekit secret: ' . $this->livekitSecret);

    }

    public function generateSignalToken(array $payload): string
    {
        $now = time();
        $exp = $now + 3600; // 1h
        $data = array_merge($payload, [
            'iat' => $now,
            'exp' => $exp,
        ]);
        return JWT::encode($data, $this->secret, 'HS256');
    }

    public function generateLivekitToken(array $payload): string
    {
        $apiKey    = $this->livekitKey;       // từ .env
        $apiSecret = $this->livekitSecret;    // từ .env

        $now = time();

        // TTL tuỳ chọn (giữ default 1 giờ)
        $ttlSeconds = isset($payload['ttl']) ? (int)$payload['ttl'] : 3600;
        if ($ttlSeconds < 60) { $ttlSeconds = 60; }
        if ($ttlSeconds > 86400) { $ttlSeconds = 86400; }

        $exp = $now + $ttlSeconds;

        /**
         * LiveKit identity (sub) phải UNIQUE trong cùng room.
         * - Nếu bạn muốn 1 user đăng nhập nhiều thiết bị/tab, hãy truyền 'identity' unique theo device/session.
         * - 'name' có thể trùng (hiển thị), metadata để map về user/device/session.
         */
        $identity = $payload['identity']
            ?? ($payload['username']
                ?? (isset($payload['user_id']) ? ("user_" . $payload['user_id']) : uniqid("guest_")));

        $name = $payload['name']
            ?? ($payload['username'] ?? ("User " . $identity));

        $metadata = $payload['metadata'] ?? null;

        $data = [
            "iss"  => $apiKey,
            "sub"  => (string)$identity,
            "iat"  => $now,
            "exp"  => $exp,
            "name" => (string)$name,
            "video" => [
                "roomJoin"     => true,
                "room"         => $payload['room'] ?? "demo",
                "canPublish"   => true,
                "canSubscribe" => true,
            ],
        ];

        if ($metadata !== null) {
            $data["metadata"] = is_string($metadata)
                ? $metadata
                : json_encode($metadata, JSON_UNESCAPED_SLASHES);
        }

        return JWT::encode($data, $apiSecret, 'HS256', $apiKey);
    }

    public function verifyCredentials(string $username, string $password): ?array
    {
        // ⚠️ DEMO ONLY: danh sách user giả lập
        $fakeUsers = [
            [
                'id'       => 1,
                'username' => 'test1',
                'password' => '123456'
            ],
            [
                'id'       => 2,
                'username' => 'test2',
                'password' => '123456'
            ],
            [
                'id'       => 3,
                'username' => 'test3',
                'password' => '123456'
            ],
            [
                'id'       => 4,
                'username' => 'test4',
                'password' => '123456'
            ]
        ];

        foreach ($fakeUsers as $user) {
            if ($user['username'] === $username && $user['password'] === $password) {
                return [
                    'id'       => $user['id'],
                    'username' => $user['username']
                ];
            }
        }

        $this->log->warning("Login failed for username: " . $username);
        return null;
    }

    public function generateServerApiToken(int $ttlSeconds = 60): string
    {
        $now = time();
        $claims = [
            'iss'  => $this->livekitKey,
            'iat'  => $now,
            'exp'  => $now + $ttlSeconds,
            // Grants cho Server API (DeleteRoom cần roomCreate)
            'video' => [
                'roomCreate' => true,
                'roomList'   => true,
                'roomAdmin'  => true,
            ],
        ];
        // KID = apiKey
        return \Firebase\JWT\JWT::encode($claims, $this->livekitSecret, 'HS256', $this->livekitKey);
    }
}

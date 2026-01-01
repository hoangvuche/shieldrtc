<?php
declare(strict_types=1);

/**
 * rateLimiter.php
 * Per-session limiter: 100 requests / 60s. Trả 429 nếu vượt ngưỡng.
 * Đặt include/require file này càng sớm càng tốt (trước mọi output).
 */

function rl_safe_session_start(): bool {
    if (session_status() === PHP_SESSION_ACTIVE) return true;
    if (headers_sent($f, $l)) {
        error_log("rateLimiter: headers already sent at $f:$l (cannot start session)");
        return false;
    }
    return session_start();
}

rl_safe_session_start(); // cố gắng mở session

// Nếu vẫn chưa có session (vì headers đã gửi), tốt nhất là bỏ qua limiter để tránh phá response
if (session_status() !== PHP_SESSION_ACTIVE) {
    // Bạn có thể chọn exit 500 ở đây, nhưng đa số nên "bỏ qua limiter" còn hơn là crash.
    return;
}

// Khóa/ghi session càng nhanh càng tốt rồi đóng để tránh block request khác
if (!isset($_SESSION['rl'])) {
    $_SESSION['rl'] = [
        'count'      => 0,
        'start_time' => time(),
    ];
}

$now   = time();
$start = $_SESSION['rl']['start_time'];
$count = (int) $_SESSION['rl']['count'];

if (($now - $start) > 60) {
    // cửa sổ mới
    $_SESSION['rl']['count'] = 1;
    $_SESSION['rl']['start_time'] = $now;
} else {
    $_SESSION['rl']['count'] = $count + 1;
}

$exceeded = ($_SESSION['rl']['count'] > 100) && (($now - $_SESSION['rl']['start_time']) < 60);

if ($exceeded) {
    // Tính thời gian còn lại của cửa sổ hiện tại
    $retryAfter = 60 - ($now - $start);
    if ($retryAfter < 1) $retryAfter = 1;

    http_response_code(429);
    header('Retry-After: ' . $retryAfter);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Too many requests, please try later.';
    exit;
}

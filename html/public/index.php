<?php
define('WEBROOT_FS_PATH', __DIR__);

require_once __DIR__ . '/../app/Bootstrap/mybootstrap.php';
include_once webroot_fs_path('/../app/Services/rateLimiter.php');
require_once webroot_fs_path('/../vendor/autoload.php');

use Dotenv\Dotenv;

// Load .env
$dotenv = Dotenv::createImmutable(__DIR__ . '/../');
$dotenv->load();

// Router v3: flexible + regex for /meeting/*, normalized path, supports subfolder deploy

$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// If app is under a subfolder, strip it out (e.g. /shieldrtc/meeting => /meeting)
$scriptDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
if ($scriptDir && $scriptDir !== '/' && str_starts_with($uriPath, $scriptDir)) {
    $uriPath = substr($uriPath, strlen($scriptDir)) ?: '/';
}

// Normalize: collapse multiple slashes, remove trailing slash (except root)
$path = preg_replace('#/+#', '/', $uriPath);
$path = ($path !== '/') ? rtrim($path, '/') : '/';

// Optionally remove /index.php prefix if present (e.g. /index.php/meeting)
$path = preg_replace('#^/index\.php#', '', $path) ?: '/';

// API route (both /api and /api/*)
if ($path === '/api' || str_starts_with($path, '/api/')) {
    require __DIR__ . '/../routes/api.php';
    exit;
}

// Meeting route: /meeting and anything under it: /meeting/*
// (Query string already ignored because we used PHP_URL_PATH)
if (preg_match('#^/meeting(?:/.*)?$#', $path)) {
    require __DIR__ . '/meeting.php';
    exit;
}

// Fallback
require __DIR__ . '/../routes/web.php';
exit;

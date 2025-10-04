<?php
require_once __DIR__ . '/../vendor/autoload.php';

use Dotenv\Dotenv;

// Load .env
$dotenv = Dotenv::createImmutable(__DIR__ . '/../');
$dotenv->load();

// Simple router
$requestUri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (strpos($requestUri, '/api/') === 0) {
    require __DIR__ . '/../routes/api.php';
} else {
    require __DIR__ . '/../routes/web.php';
}

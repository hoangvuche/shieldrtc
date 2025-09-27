<?php
// Minimal router stub to unblock health check. Replace with real routes.
header('Content-Type: application/json');

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if ($uri === '/api/health') {
    echo json_encode(['status' => 'ok', 'time' => date('c')]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'Not Implemented', 'path' => $uri]);

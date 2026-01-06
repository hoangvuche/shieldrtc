<?php
/* ===========================
* TEST DATABASE CONNECTION
* =========================== */
try {
    // lấy DbHelper từ bootstrap
    $db = require webroot_fs_path('/../app/Bootstrap/database.php');

    // test nhẹ nhất
    $ok = $db->selectSingleValue('SELECT 1');

    if ($ok !== '1' && $ok !== 1) {
        throw new \Exception('Unexpected DB test result');
    }

    error_log("ok value: $ok");

} catch (\Throwable $dbEx) {
    logError('db.connection.test_failed', $dbEx, [
        'user_id' => $userId,
    ]);

    http_response_code(500);
    ResponseHelper::json([
        'error'   => 'Database connection failed',
        'message' => 'DB is not reachable',
    ]);
    break;
}
/* =========================== */

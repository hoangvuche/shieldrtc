<?php
// 2️⃣ Load config & helper global (nếu bạn đang dùng)
require_once webroot_fs_path('/../config/config.php');
require_once webroot_fs_path('/../app/Helpers/db_conn_helper.php');

use Monolog\Logger;
use Monolog\Handler\StreamHandler;
use App\Helpers\Database;
use App\Helpers\DbHelper;

// 3️⃣ Init Logger (1 lần, dùng chung)
$logger = new Logger(LOG_TAG_DB_CONNECTION);
$logger->pushHandler(
    new StreamHandler(LOG_FILE_DB_CONNECTION, Logger::INFO)
);

// 4️⃣ Init Database (singleton)
$dbInstance = Database::getInstance($logger);
$mysqli = $dbInstance->getConnection();

// 5️⃣ Wrap bằng DbHelper (thứ Repo dùng)
$db = new DbHelper($mysqli, $logger);

// 6️⃣ Trả DbHelper cho file require
return $db;

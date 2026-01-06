<?php
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

define('LOG_TAG_DB_CONNECTION', 'dbconn');
define('LOG_FILE_DB_CONNECTION', WEBROOT_FS_PATH . '/../storage/logs/my_app_db_conn.log');

define('APP_CONFIG_DIR', WEBROOT_FS_PATH . '/../config');
define('APP_CONFIG_FILE', 'app_config.json');
define('DEBUG_CONFIG_FILE', 'debug_config.json');

function getConfig($log = null, $config_file = null) {
    if (!defined('APP_CONFIG_DIR')) {
        throw new RuntimeException("Missing APP_CONFIG_DIR constant", 1);
    }

    $configDir = APP_CONFIG_DIR;
    $configFile = $config_file ?? APP_CONFIG_FILE;

    // Combine the directory path with the config file name
    $configFilePath = $configDir . "/$configFile";

    $log->info("config file path: $configFilePath");

    // Check if the config file exists and is readable
    if (file_exists($configFilePath) && is_readable($configFilePath)) {
        // Read the contents of the JSON file
        $jsonContent = file_get_contents($configFilePath);
        $config = json_decode($jsonContent, true);

        if (json_last_error() === JSON_ERROR_NONE) {
            return $config;
        } else {
            if ($log) {
                $log->error("JSON error");
            }
            return null;
        }

    } else {
        if ($log) {
            $log->error("Config file not found");
        }
        return null;
    }
}

function getConfigItem($configName, $log = null, $config_file = null) {
    $config = getConfig($log, $config_file);
    return is_array($config) && isset($config[$configName]) ? $config[$configName] : null;
}

function getConfigItems(array $keyDefaults, $log = null, $config_file = null): array
{
    $config = getConfig($log, $config_file);
    if (!is_array($config)) $config = [];

    $out = [];
    foreach ($keyDefaults as $key => $default) {
        // cho phép truyền list keys dạng ['ws_url','worker'] nữa
        if (is_int($key)) {
            $k = (string)$default;
            $out[$k] = array_key_exists($k, $config) ? $config[$k] : null;
            continue;
        }

        $k = (string)$key;
        $out[$k] = array_key_exists($k, $config) ? $config[$k] : $default;
    }
    return $out;
}

function validate($data, $isPass = false) {
    $data = trim($data);

    if (!$isPass) {
        $data = htmlspecialchars($data, ENT_QUOTES, 'UTF-8');
    }

    return $data;
}

class SystemConfig {

    private $dbConnect;
    private $sname = "";
    private $uname = "";
    private $password = "";
    private $db_name = "";

    function __construct(){

    }
    
    function __destruct() {
        $this->dbConnect->close();
    }
    
    function connectDB(){
        try {
            $this->dbConnect = new mysqli($this->sname, $this->uname, $this->password, $this->db_name);
        } catch (\Exception $e) {
            throw $e;
        }
        
        if($this->dbConnect->connect_errno){
            return null; 
        }else{
            return $this->dbConnect;
        }
    }
    
    public static function getStatusCodeMessage($status){
        $codes = Array(
            100 => "Continue",
            101 => "Switching Protocols",
            200 => "OK",
            201 => "Created",
            202 => "Accepted",
            203 => "Non-Authoritative Information",
            204 => "No Content",
            205 => "Reset Content",
            206 => "Partial Content",
            300 => "Multiple Choices",
            301 => "Moved Permanently",
            302 => "Found",
            303 => "See Other",
            304 => "Not Modified",
            305 => "Use Proxy",
            306 => "(Unused)",
            307 => "Temporary Redirect",
            400 => "Bad Request",
            401 => "Unauthorized",
            402 => "Payment Required",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            406 => "Not Acceptable",
            407 => "Proxy Authentication Required",
            408 => "Request Timeout",
            409 => "Conflict",
            410 => "Gone",
            411 => "Length Required",
            412 => "Precondition Failed",
            413 => "Request Entity Too Large",
            414 => "Request-URI Too Long",
            415 => "Unsupported Media Type",
            416 => "Requested Range Not Satisfiable",
            417 => "Expectation Failed",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            501 => "Not Implemented",
            502 => "Bad Gateway",
            503 => "Service Unavailable",
            504 => "Gateway Timeout",
            505 => "HTTP Version Not Supported"
        );
        
        return (isset($codes[$status])) ? $codes[$status] : ”;
    }

    public static function sendResponse($status = 200, $body = '', $content_type = "application/json")
    {
        $status_header = "HTTP/1.1 " . $status . " " . self::getStatusCodeMessage($status);
        header($status_header);
        header("Content-type: " . $content_type . "; charset=utf-8");
        echo $body;
        exit();
    }

    public static function generateJWT($userId, $secretKey = 'B2681CD61DB4BED4D99A97817BC8E') {
        // Payload data for the token
        $payload = [
            'iss' => 'plusdebt.asia',  // Issuer
            'aud' => 'plusdebt.asia',  // Audience
            'iat' => time(),             // Issued at: current time
            // 'exp' => time() + (60 * 60), // Expiration time: 1 hour from now
            'user_id' => $userId         // Custom data (e.g., user ID)
        ];
    
        // Encode the payload using your secret key
        $jwt = JWT::encode($payload, $secretKey, 'HS256');
    
        return $jwt;
    }

    public static function generateExceptionJWT($sender, $receiver, $secretKey = 'B2681CD61DB4BED4D99A97817BC8E') {
        // Payload data for the token
        $payload = [
            'iss' => 'plusdebt.asia',  // Issuer
            'aud' => 'plusdebt.asia',  // Audience
            'iat' => time(),             // Issued at: current time
            'sender' => $sender,         // Custom data (e.g., user ID)
            'receiver' => $receiver
        ];
    
        // Encode the payload using your secret key
        $jwt = JWT::encode($payload, $secretKey, 'HS256');
    
        return $jwt;
    }

    public static function sendMail($recipients, $subject, $htmlContent, $plainContent, $log, $smtpConfig = [], $attachments = []) {
        try {
            $mail = new PHPMailer(true); // bật exceptions
            $mail->CharSet = "UTF-8";
            $mail->isSMTP();
            $config = getConfig();

            $mail->Host       = $smtpConfig['host']      ?? decryptData($config['MAIL_HOST_NAME'], $config['encryption_key'], $config['encryption_iv']);
            $mail->SMTPAuth   = true;
            $mail->Username   = $smtpConfig['username']  ?? $config['MAIL_USERNAME'];
            $mail->Password   = $smtpConfig['password']  ?? decryptData($config['MAIL_PASSWORD'], $config['encryption_key'], $config['encryption_iv']);
            $mail->SMTPSecure = $smtpConfig['encryption']?? 'tls';
            $mail->Port       = $smtpConfig['port']      ?? 587;
            $mail->SMTPKeepAlive = true;

            $fromEmail = $smtpConfig['fromEmail'] ?? 'callcentervn@plusdebt.asia';
            $fromName  = $smtpConfig['fromName']  ?? 'Call Center Vietnam';
            $mail->setFrom($fromEmail, $fromName);
            $mail->Subject = $subject;
            $mail->isHTML(true); // gửi HTML đúng chuẩn
            $anySent = false;

            foreach ($recipients as $recipient) {
                $email = $recipient['email'] ?? '';
                $name  = $recipient['name']  ?? '';

                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                    if ($log) $log->error("Invalid recipient email: ".var_export($email, true));
                    continue;
                }

                $mail->clearAddresses(); // dọn trước mỗi lượt
                $mail->addAddress($email, $name);
                $mail->Body    = $htmlContent;
                $mail->AltBody = $plainContent;

                // Attachments (giữ nguyên như bạn có)
                foreach (($attachments ?? []) as $attachment) {
                    if (isset($attachment['binaryData'], $attachment['fileName'])) {
                        $mail->addStringAttachment($attachment['binaryData'], $attachment['fileName']);
                    } elseif (isset($attachment['filePath'], $attachment['fileName'])) {
                        $mail->addAttachment($attachment['filePath'], $attachment['fileName']);
                    }
                }

                try {
                    if ($mail->send()) {
                        $anySent = true;
                        if ($log) $log->info("Message sent to: {$name} ({$email})");
                    } else {
                        if ($log) $log->error("Mail failed to {$name} ({$email}): ".$mail->ErrorInfo);
                    }
                } catch (Exception $e) {
                    if ($log) $log->error("Mail exception to {$name} ({$email}): ".$e->getMessage());
                }
            }

            $mail->smtpClose();
            return $anySent; // chỉ true nếu có ít nhất 1 mail gửi thành công
        } catch (Exception $e) {
            if ($log) $log->error("Error sending email: " . $e->getMessage());
            return false;
        }
    }

    public static function sendMailV2(
        array $recipients,                // [['email'=>'a@x','name'=>'A'], ...]
        string $subject,
        string $htmlContent,
        ?string $plainContent,
        $log,
        array $smtpConfig = [],           // ['host','username','password','encryption','port','fromEmail','fromName']
        array $attachments = [],          // [['binaryData'=>..., 'fileName'=>...], ['filePath'=>..., 'fileName'=>...]]
        array $cc = [],                   // [['email'=>'c@x','name'=>'C'], ...]
        ?array $replyTo = null,           // ['email'=>'me@x','name'=>'Me']
        bool $strict = false              // NEW: false = ≥1 thành công; true = tất cả thành công
    ) {
        try {
            $mail = new PHPMailer(true);  // bật exceptions
            $mail->CharSet = "UTF-8";
            $mail->isSMTP();

            $config = getConfig();

            $mail->Host          = $smtpConfig['host']       ?? decryptData($config['MAIL_HOST_NAME'], $config['encryption_key'], $config['encryption_iv']);
            $mail->SMTPAuth      = true;
            $mail->Username      = $smtpConfig['username']   ?? $config['MAIL_USERNAME'];
            $mail->Password      = $smtpConfig['password']   ?? decryptData($config['MAIL_PASSWORD'], $config['encryption_key'], $config['encryption_iv']);
            $mail->SMTPSecure    = $smtpConfig['encryption'] ?? 'tls';
            $mail->Port          = $smtpConfig['port']       ?? 587;
            $mail->SMTPKeepAlive = true;

            // Envelope sender = SMTP login (return-path). Tương thích server yêu cầu "sender == auth user"
            $loginUser = $mail->Username;
            $mail->Sender = $loginUser;

            // From: nếu không truyền fromEmail -> fallback = username (tránh reject do không khớp)
            $fromEmail = $smtpConfig['fromEmail'] ?? $loginUser;
            $fromName  = $smtpConfig['fromName']  ?? 'Call Center Vietnam';
            $mail->setFrom($fromEmail, $fromName);

            $mail->isHTML(true);
            $mail->Subject = $subject;

            // Reply-To (nếu có)
            if (is_array($replyTo) && !empty($replyTo['email'])) {
                $mail->addReplyTo($replyTo['email'], $replyTo['name'] ?? '');
            }

            $sentCount = 0;
            $failCount = 0;

            // Gửi lần lượt từng recipient
            foreach ($recipients as $recipient) {
                $toEmail = $recipient['email'] ?? '';
                $toName  = $recipient['name']  ?? '';

                // Validate email
                if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
                    $failCount++;
                    if ($log) $log->error("Invalid recipient email: ".var_export($toEmail, true));
                    continue;
                }

                try {
                    // To
                    $mail->addAddress($toEmail, $toName);

                    // CC cho lượt này (lọc email hợp lệ)
                    if (!empty($cc)) {
                        foreach ($cc as $ccItem) {
                            if (is_array($ccItem) && !empty($ccItem['email']) && filter_var($ccItem['email'], FILTER_VALIDATE_EMAIL)) {
                                $mail->addCC($ccItem['email'], $ccItem['name'] ?? '');
                            }
                        }
                    }

                    // Nội dung
                    $mail->Body    = $htmlContent;
                    $mail->AltBody = ($plainContent !== null && $plainContent !== '')
                                    ? $plainContent
                                    : strip_tags($htmlContent);

                    // Đính kèm cho lượt này
                    foreach ($attachments as $att) {
                        if (isset($att['binaryData'], $att['fileName'])) {
                            $mail->addStringAttachment($att['binaryData'], $att['fileName']);
                        } elseif (isset($att['filePath'], $att['fileName'])) {
                            $mail->addAttachment($att['filePath'], $att['fileName']);
                        }
                    }

                    // Gửi
                    $ok = $mail->send();
                    if ($ok) {
                        $sentCount++;
                        if ($log) $log->info("Message sent to: {$toName} ({$toEmail})");
                    } else {
                        $failCount++;
                        if ($log) $log->error("Mail failed to {$toName} ({$toEmail}): ".$mail->ErrorInfo);
                    }
                } catch (Exception $e) {
                    $failCount++;
                    if ($log) $log->error("Mail exception to {$toName} ({$toEmail}): ".$e->getMessage());
                } finally {
                    // Clear cho vòng kế tiếp
                    $mail->clearAddresses();
                    $mail->clearCCs();
                    $mail->clearAttachments();
                    // Giữ nguyên Reply-To; nếu cần reset: $mail->clearReplyTos();
                }
            }

            $mail->smtpClose();

            // Kết quả theo chế độ strict/non-strict
            if ($strict) {
                // strict: tất cả thành công và có ≥1 người nhận
                return ($sentCount > 0 && $failCount === 0);
            }
            // non-strict (default): có ít nhất 1 thành công
            return ($sentCount > 0);

        } catch (Exception $e) {
            if ($log) $log->error("Error sending email: " . $e->getMessage());
            return false;
        }
    }
}
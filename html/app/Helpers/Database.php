<?php

namespace App\Helpers;

use Monolog\Logger;
use Monolog\Handler\StreamHandler;
use Exception;

class Database
{
    private static ?Database $instance = null;

    private \mysqli $connection;
    private Logger $log;
    private array $config = [];

    /**
     * ⚠️ Constructor PRIVATE (Singleton)
     * Mọi dependency phải được load từ bootstrap
     */
    private function __construct(Logger $logger)
    {
        $this->log = $logger;

        try {
            $this->loadConfig();

            $this->connection = new \mysqli(
                decryptData($this->config['db_host'], $this->config['encryption_key'], $this->config['encryption_iv']),
                decryptData($this->config['db_user'], $this->config['encryption_key'], $this->config['encryption_iv']),
                decryptData($this->config['db_pass'], $this->config['encryption_key'], $this->config['encryption_iv']),
                decryptData($this->config['db_name'], $this->config['encryption_key'], $this->config['encryption_iv'])
            );

        } catch (Exception $e) {
            $this->log->error('Database connection failed', [
                'error' => $e->getMessage(),
            ]);
            throw new Exception('Database connection failed');
        }
    }

    /**
     * Load config từ helper global (đã được bootstrap load)
     */
    private function loadConfig(): void
    {
        $this->config = getConfig($this->log);

        if (!$this->config) {
            throw new Exception('Database configuration not found');
        }
    }

    /**
     * Singleton accessor
     */
    public static function getInstance(Logger $logger): Database
    {
        if (self::$instance === null) {
            self::$instance = new self($logger);
        }
        return self::$instance;
    }

    /**
     * Get mysqli connection
     */
    public function getConnection(): \mysqli
    {
        return $this->connection;
    }

    private function __clone() {}

    public function __wakeup()
    {
        throw new Exception('Cannot unserialize singleton');
    }
}

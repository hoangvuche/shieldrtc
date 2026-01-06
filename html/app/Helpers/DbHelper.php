<?php

namespace App\Helpers;

use mysqli;
use Exception;
use mysqli_stmt;
use RuntimeException;

class DbHelper {
    private mysqli $conn;
    private $log;

    public function __construct(mysqli $conn, $log) {
        $this->conn = $conn;
        $this->log = $log;
    }

    public function selectSingle(string $sql, string $types, array $params, array &$results, bool $diffErrorOrNull = false): bool|null {
        try {
            $stmt = $this->conn->prepare($sql);
            if (!$stmt) {
                throw new Exception("MySQL prepare error: " . $this->conn->error);
            }
    
            if (!empty($params)) {
                if (!is_array($params)) {
                    throw new Exception("Invalid data type: expected array, received " . gettype($params), 1);
                }

                if (strlen($types) !== count($params)) {
                    throw new Exception("bind_param mismatch: types=".strlen($types)." params=".count($params));
                }

                $this->bindChecked($stmt, $types, $params, $sql);
            }
    
            if (!$stmt->execute()) {
                throw new Exception("MySQL execute error: " . $stmt->error);
            }
    
            $meta = $stmt->result_metadata();
            if (!$meta) {
                $stmt->close();
                return $diffErrorOrNull ? null : false;
            }
    
            $results = [];
            $refs = [];
            while ($field = $meta->fetch_field()) {
                $results[$field->name] = null;
                $refs[] = &$results[$field->name];
            }
            $meta->free();
    
            call_user_func_array([$stmt, 'bind_result'], $refs);
    
            $fetched = $stmt->fetch();
            $stmt->close();
    
            if (!$fetched) {
                return $diffErrorOrNull ? null : false;
            }
    
            return true;
    
        } catch (Exception $e) {
            $this->log->error("selectSingle error: " . $e->getMessage());
            throw $e;
        }
    }
    
    public function selectSingleRow(string $sql, string $types = '', array $params = []) : ?array {
        $row = [];
        $ok = $this->selectSingle($sql, $types, $params, $row, true); // empty => null
        return $ok === true ? $row : null;
    }

    /**
     * Lấy nhanh 1 giá trị (cột đầu tiên) — tiện cho COUNT(*), MIN/MAX, v.v.
     * @return string|null
     */
    public function selectSingleValue(string $sql, string $types = '', array $params = []) {
        $row = [];
        $ok = $this->selectSingle($sql, $types, $params, $row, true);
        if ($ok === true) {
            foreach ($row as $v) { return $v; } // cột đầu tiên
        }
        return null;
    }

    public function selectSingleV2(string $sql, string $types = '', array $params = []): ?array
    {
        try {
            $stmt = $this->conn->prepare($sql);
            if (!$stmt) {
                throw new Exception("MySQL prepare error: " . $this->conn->error);
            }

            if (!empty($params)) {
                if (!is_array($params)) {
                    $stmt->close();
                    throw new Exception("Invalid data type: expected array, received " . gettype($params));
                }
                if (strlen($types) !== count($params)) {
                    $stmt->close();
                    throw new Exception("bind_param mismatch: types=" . strlen($types) . " params=" . count($params));
                }
                $this->bindChecked($stmt, $types, $params, $sql);
            }

            if (!$stmt->execute()) {
                $err = $stmt->error ?: 'unknown execute error';
                $stmt->close();
                throw new Exception("MySQL execute error: " . $err);
            }

            $meta = $stmt->result_metadata();
            if (!$meta) {
                // Không có result set (không phải SELECT) → coi như không có dòng
                $stmt->close();
                return null;
            }

            // Chuẩn bị bind kết quả sang mảng
            $row = [];
            $refs = [];
            while ($field = $meta->fetch_field()) {
                $row[$field->name] = null;
                $refs[] = &$row[$field->name];
            }
            $meta->free();

            call_user_func_array([$stmt, 'bind_result'], $refs);

            $fetched = $stmt->fetch();

            if ($fetched === true) {
                $stmt->close();
                return $row;                 // có dữ liệu
            }

            if ($fetched === null) {
                $stmt->close();
                return null;                 // không có dòng nào
            }

            // $fetched === false → lỗi fetch
            $err = $stmt->error ?: 'unknown fetch error';
            $stmt->close();
            throw new Exception("MySQL fetch error: " . $err);

        } catch (Exception $e) {
            $this->log->error("selectSingleV2 error: " . $e->getMessage());
            throw $e;
        }
    }

    public function selectMulti(string $sql, string $types = '', array $params = []): array {
        try {
            $stmt = $this->conn->prepare($sql);
            if (!$stmt) {
                throw new Exception("MySQL prepare error: " . $this->conn->error);
            }

            if ($types && $params) {
                if (!is_array($params)) {
                    throw new Exception("Invalid data type: expected array, received " . gettype($params), 1);
                    
                }

                $this->bindChecked($stmt, $types, $params, $sql);
            }

            if (!$stmt->execute()) {
                throw new Exception("MySQL execute error: " . $stmt->error);
            }

            $result = $stmt->get_result();
            if (!$result) {
                throw new Exception("MySQL get_result error: " . $stmt->error);
            }

            $rows = [];
            while ($row = $result->fetch_assoc()) {
                $rows[] = $row;
            }

            $stmt->close();
            return $rows;

        } catch (Exception $e) {
            $this->log->error("selectMulti error: " . $e->getMessage());
            throw $e;
        }
    }

    public function insert(string $sql, string $types, array $params, bool $returnInsertId = false): int {
        return $this->execute($sql, $types, $params, true);
    }

    public function update(string $sql, string $types, array $params): int {
        return $this->execute($sql, $types, $params);
    }

    public function delete(string $sql, string $types = '', array $params = []): int {
        return $this->execute($sql, $types, $params);
    }

    private function execute(string $sql, string $types = '', array $params = [], bool $returnInsertId = false): int {
        try {
            $stmt = $this->conn->prepare($sql);
            if (!$stmt) {
                throw new Exception("MySQL prepare error: " . $this->conn->error);
            }

            if ($types && !empty($params)) {
                $this->bindChecked($stmt, $types, $params, $sql);

                // Send blob data in chunks for 'b' types
                for ($i = 0; $i < strlen($types); $i++) {
                    if ($types[$i] === 'b') {
                        $stmt->send_long_data($i, $params[$i]);
                    }
                }
            }

            if (!$stmt->execute()) {
                throw new Exception("MySQL execute error: " . $stmt->error);
            }

            $affected = $returnInsertId ? $this->conn->insert_id : $stmt->affected_rows;
            $stmt->close();

            return $affected;

        } catch (Exception $e) {
            $this->log->error("execute error: " . $e->getMessage());
            throw $e;
        }
    }

    public function executeBatch(string $sql, string $types, array $batchParams): int {
        try {
            $stmt = $this->conn->prepare($sql);
            if (!$stmt) {
                throw new Exception("MySQL prepare error: " . $this->conn->error);
            }
    
            $totalAffectedRows = 0;
    
            foreach ($batchParams as $params) {
                if (count($params) !== strlen($types)) {
                    throw new Exception("Parameter count does not match types length.");
                }
    
                $this->bindChecked($stmt, $types, $params, $sql);
    
                if (!$stmt->execute()) {
                    throw new Exception("MySQL execute error: " . $stmt->error);
                }
    
                $totalAffectedRows += $stmt->affected_rows;
            }
    
            $stmt->close();
            return $totalAffectedRows;
    
        } catch (Exception $e) {
            $this->log->error("executeBatch error: " . $e->getMessage());
            throw $e;
        }
    }    

    public function rawQuery(string $sql): bool {
        try {
            if (!$this->conn->query($sql)) {
                throw new Exception("MySQL raw query error: " . $this->conn->error);
            }
            return true;
        } catch (Exception $e) {
            $this->log->error("rawQuery error: " . $e->getMessage());
            throw $e;
        }
    }

    public function quote(string $value): string {
        return "'" . $this->conn->real_escape_string($value) . "'";
    }

    public function begin_transaction() {
        $this->conn->begin_transaction();
    }

    public function commit() {
        $this->conn->commit();
    }

    public function rollback() {
        $this->conn->rollback();
    }

    public function getConn() {
        if (!$this->conn) throw new Exception("DB Connection not initialized");
        return $this->conn;
    }
    
    public function getLog() {
        if (!$this->log) throw new Exception("Logger not initialized");
        return $this->log;
    }

    private function bindChecked(mysqli_stmt $stmt, string $types, array $params, string $sql): void
    {
        $need = strlen($types);
        $have = count($params);

        if ($need !== $have) {
            throw new RuntimeException(
                "BIND_MISMATCH need={$need} have={$have} types='{$types}' sql=" . preg_replace('/\s+/', ' ', trim($sql))
            );
        }

        // bind_param cần biến by-ref
        $refs = [];
        foreach ($params as $k => $v) {
            $refs[$k] = &$params[$k];
        }

        $stmt->bind_param($types, ...$refs);
    }
}

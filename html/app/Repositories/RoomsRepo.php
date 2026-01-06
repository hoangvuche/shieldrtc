<?php

namespace App\Repositories;

use App\Helpers\DbHelper;
use Monolog\Logger;
use Throwable;

class RoomsRepo
{
    private DbHelper $db;
    private Logger $log;

    public function __construct(DbHelper $db)
    {
        $this->db  = $db;
        $this->log = $db->getLog();
    }

    /**
     * Lưu UTC để đồng bộ đa server/node.
     * (DB datetime không timezone)
     */
    private function now(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    /* =========================================================
     * Room lifecycle
     * ========================================================= */

    /**
     * Create room: idempotent (retry/double-click không làm chết flow).
     * - Nếu room_id đã tồn tại: không tạo mới, không throw do UNIQUE.
     * - Không tự đổi owner (giữ an toàn). Nếu muốn overwrite owner khi trùng, đổi UPDATE.
     */
    public function createRoom(string $roomId, int $ownerId): void
    {
        // ON DUPLICATE KEY UPDATE no-op để tránh lỗi UNIQUE
        $this->db->insert(
            "INSERT INTO rooms (room_id, owner_id, status, created_at)
             VALUES (?, ?, 'active', ?)
             ON DUPLICATE KEY UPDATE
               room_id = room_id",
            'sis',
            [$roomId, $ownerId, $this->now()]
        );

        // log event create (best-effort)
        $this->logAction($roomId, $ownerId, 'create');
    }

    public function getRoomById(string $roomId): ?array
    {
        return $this->db->selectSingleRow(
            "SELECT room_id, owner_id, status, created_at, ended_at, disbanded_at
             FROM rooms
             WHERE room_id = ?
             LIMIT 1",
            's',
            [$roomId]
        );
    }

    public function getStatus(string $roomId): ?string
    {
        $v = $this->db->selectSingleValue(
            "SELECT status FROM rooms WHERE room_id = ? LIMIT 1",
            's',
            [$roomId]
        );
        return $v !== null ? (string)$v : null;
    }

    /**
     * Throw nếu room không tồn tại (tiện cho controller).
     */
    public function requireRoom(string $roomId): array
    {
        $room = $this->getRoomById($roomId);
        if (!$room) {
            throw new \RuntimeException('ROOM_NOT_FOUND');
        }
        return $room;
    }

    /**
     * Throw nếu room không active (ended/disbanded).
     */
    public function requireActiveRoom(string $roomId): array
    {
        $room = $this->requireRoom($roomId);
        if (($room['status'] ?? '') !== 'active') {
            throw new \RuntimeException('ROOM_NOT_ACTIVE');
        }
        return $room;
    }

    /* =========================================================
     * Permission
     * ========================================================= */

    public function isOwner(string $roomId, int $userId): bool
    {
        $row = $this->db->selectSingleRow(
            "SELECT 1 FROM rooms
             WHERE room_id = ? AND owner_id = ?
             LIMIT 1",
            'si',
            [$roomId, $userId]
        );

        return $row !== null;
    }

    /**
     * Return true/false theo room record (khỏi query 2 lần).
     */
    public function isOwnerByRoomRow(array $roomRow, int $userId): bool
    {
        return isset($roomRow['owner_id']) && (int)$roomRow['owner_id'] === (int)$userId;
    }

    /* =========================================================
     * Join / Leave (Audit helpers)
     * ========================================================= */

    /**
     * Join room: check room exists + active, rồi log join.
     * Trả room row để caller tính is_host.
     */
    public function joinRoom(string $roomId, int $userId): array
    {
        $room = $this->requireActiveRoom($roomId);

        // Audit best-effort
        $this->logJoin($roomId, $userId);

        return $room;
    }

    /**
     * Leave room: không đổi trạng thái room, chỉ audit.
     */
    public function leaveRoom(string $roomId, int $userId): void
    {
        // nếu room không tồn tại thì thôi, không cần throw
        $room = $this->getRoomById($roomId);
        if (!$room) return;

        $this->logLeave($roomId, $userId);
    }

    /* =========================================================
     * State transitions
     * ========================================================= */

    /**
     * Soft end room (thường owner mới được end).
     * - Nếu requireOwner=true thì check owner trước khi end.
     * - Idempotent: nếu room không active thì không update.
     */
    public function markEnded(string $roomId, int $userId, bool $requireOwner = false): void
    {
        if ($requireOwner && !$this->isOwner($roomId, $userId)) {
            throw new \RuntimeException('ONLY_OWNER_CAN_END');
        }

        $affected = $this->db->update(
            "UPDATE rooms
             SET status = 'ended', ended_at = ?
             WHERE room_id = ? AND status = 'active'",
            'ss',
            [$this->now(), $roomId]
        );

        if ($affected > 0) {
            $this->logAction($roomId, $userId, 'end');
        }
    }

    /**
     * Disband room (owner-only).
     * - Idempotent: nếu đã disbanded thì không update nữa.
     */
    public function markDisbanded(string $roomId, int $userId, bool $requireOwner = true): void
    {
        if ($requireOwner && !$this->isOwner($roomId, $userId)) {
            throw new \RuntimeException('ONLY_OWNER_CAN_DISBAND');
        }

        $affected = $this->db->update(
            "UPDATE rooms
             SET status = 'disbanded', disbanded_at = ?
             WHERE room_id = ? AND status != 'disbanded'",
            'ss',
            [$this->now(), $roomId]
        );

        if ($affected > 0) {
            $this->logAction($roomId, $userId, 'disband');
        }
    }

    /* =========================================================
     * Audit / events
     * ========================================================= */

    public function logJoin(string $roomId, int $userId): void
    {
        $this->logAction($roomId, $userId, 'join');
    }

    public function logLeave(string $roomId, int $userId): void
    {
        $this->logAction($roomId, $userId, 'leave');
    }

    private function logAction(string $roomId, int $userId, string $action): void
    {
        try {
            $this->db->insert(
                "INSERT INTO room_events (room_id, user_id, action, created_at)
                 VALUES (?, ?, ?, ?)",
                'siss',
                [$roomId, $userId, $action, $this->now()]
            );

            $this->log->info('room_event', [
                'room_id' => $roomId,
                'user_id' => $userId,
                'action'  => $action,
            ]);

        } catch (Throwable $e) {
            /**
             * Audit log KHÔNG được phép phá flow chính
             * → chỉ log lỗi
             */
            $this->log->error('room_event_failed', [
                'room_id' => $roomId,
                'user_id' => $userId,
                'action'  => $action,
                'error'   => $e->getMessage(),
            ]);
        }
    }
}

<?php
if (!defined('WEBROOT_FS_PATH')) {
    throw new RuntimeException('WEBROOT_FS_PATH must be defined by entrypoint.');
}

function asset(string $path, ?string $ver = null, ?string $base = null): string
{
    // URL ngoài (cdn, http, https, //) → trả nguyên
    if (preg_match('#^(?:https?:)?//#i', $path)) {
        return $path;
    }

    // Base URL (vd app chạy ở /op)
    if ($base === null) {
        $scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
        $base = rtrim(str_replace('\\', '/', dirname($scriptName)), '/');
        if ($base === '/' || $base === '\\') {
            $base = '';
        }
    }

    $path = '/' . ltrim($path, '/');

    // URL hiển thị
    $url = ($path[0] === '/')
        ? ($base . $path)
        : ($base . '/' . ltrim($path, '/'));

    // Chuẩn hoá //
    $url = preg_replace('#/{2,}#', '/', $url);

    // Version theo mtime (filesystem thật)
    if ($ver === null && defined('WEBROOT_FS_PATH')) {
        $fsPath = rtrim(WEBROOT_FS_PATH, '/') . $path;
        if (is_file($fsPath)) {
            $ver = (string) filemtime($fsPath);
        }
    }

    return $ver ? ($url . '?v=' . rawurlencode($ver)) : $url;
}

function webroot_fs_path(string $path, bool $mustExist = true): string
{
    if (preg_match('#^(?:https?:)?//#i', $path)) {
        throw new InvalidArgumentException('webroot_fs_path không nhận URL.');
    }

    $fs = rtrim(WEBROOT_FS_PATH, '/') . '/' . ltrim($path, '/');

    if ($mustExist && !is_file($fs)) {
        throw new RuntimeException("File not found: {$fs}");
    }

    return $fs;
}

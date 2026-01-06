<?php
function logError(string $tag, \Throwable $e, array $context = [])
{
    error_log(json_encode([
        'level'   => 'error',
        'tag'     => $tag,
        'message' => $e->getMessage(),
        'file'    => $e->getFile(),
        'line'    => $e->getLine(),
        'trace'   => $e->getTraceAsString(),
        'context' => $context,
        'time'    => date('c'),
    ]));
}

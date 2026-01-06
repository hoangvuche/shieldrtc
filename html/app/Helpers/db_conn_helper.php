<?php
function decryptData($encrypted, $key, $iv) {
    $decrypted = openssl_decrypt($encrypted, 'aes-256-cbc', $key, 0, base64_decode($iv));
    return $decrypted;
}

function encryptData($data, $key, $iv) {
    $encrypted = openssl_encrypt($data, 'aes-256-cbc', $key, 0, base64_decode($iv));    
    return $encrypted; // Return Base64-encoded encrypted string
}

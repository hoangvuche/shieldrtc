<?php
namespace App\Controllers;

class BaseController
{
    protected function getJsonInput(): array
    {
        $data = file_get_contents("php://input");
        return $data ? json_decode($data, true) ?? [] : [];
    }
}

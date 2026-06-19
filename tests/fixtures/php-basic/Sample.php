<?php

class Sample
{
    public function square(int $n): int
    {
        return $n * $n;
    }
}

interface Greeter
{
    public function greet(): string;
}

trait Loggable
{
    public function log(): void {}
}

enum Suit
{
    case Hearts;
}

function helper(): int
{
    return 42;
}

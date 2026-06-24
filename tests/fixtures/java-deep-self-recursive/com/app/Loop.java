package com.app;

class Loop {
    int count(int value) {
        if (value <= 0) {
            return 0;
        }
        return count(value - 1);
    }
}

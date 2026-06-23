package com.app;

class Sample {
  int square(int x) {
    return mul(x, x);
  }

  int mul(int a, int b) {
    return a * b;
  }

  int recurse(int n) {
    return n <= 1 ? 1 : recurse(n - 1);
  }

  void log() {
    System.out.println(square(2));
  }
}

package com.app;

import com.util.Helper;

class Client {
  // Calls an overloaded method cross-file.
  // Baseline tier: resolves to the FIRST matching definition in Helper.java (first-wins, #15).
  String run(int x) {
    return Helper.format(x);
  }
}

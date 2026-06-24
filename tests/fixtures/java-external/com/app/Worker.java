package com.app;

// `Runnable` is a JDK type — not in this repo, so it can't resolve to an on-disk node. node(Worker)
// must surface it as an external supertype (#47), not silently drop it.
class Worker implements Runnable {
  public void run() {}
}

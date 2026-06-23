package com.svc;

import com.repo.Repo;

class Svc {
  Repo repo;
  int a, b;
  java.util.List<Repo> cache;

  Repo lookup(Repo other) {
    return other;
  }
}

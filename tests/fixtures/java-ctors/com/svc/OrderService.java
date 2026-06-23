package com.svc;

import com.repo.OrderRepository;

public class OrderService {
  private final OrderRepository repo;

  public OrderService(OrderRepository repo) {
    this.repo = repo;
  }
}

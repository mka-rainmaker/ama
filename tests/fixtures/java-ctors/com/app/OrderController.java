package com.app;

import com.svc.OrderService;
import com.repo.OrderRepository;

class OrderController {
  OrderService wire(OrderRepository repo) {
    return new OrderService(repo);
  }
}

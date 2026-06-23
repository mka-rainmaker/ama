package com.zoo;

import com.zoo.Animal;
import com.zoo.Pet;

class Dog extends Animal implements Pet {
  String speak() {
    return "Woof";
  }

  public String name() {
    return "Rex";
  }
}

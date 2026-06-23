class Widget {
  Widget() {}

  Widget(int n) {}
}

class Gadget {
  Gadget() {}
}

class Factory {
  Gadget makeGadget() {
    return new Gadget();
  }

  Widget makeWidget() {
    return new Widget(1);
  }
}

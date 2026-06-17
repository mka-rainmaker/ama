// Fixture for get/set accessors as nodes: the accessor should become a Property
// node, and the getter's return type should attribute to it as a UsesType edge.
export class Widget {}

export class Box {
  get value(): Widget {
    return new Widget();
  }
  set value(w: Widget) {
    void w;
  }
}

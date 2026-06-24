package com.app;

class UsesNested {
    String run(Outer.Inner inner) {
        return inner.render();
    }
}

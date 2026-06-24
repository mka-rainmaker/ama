package com.app;

// No `import com.app.Validator;` — a same-package sibling needs none in Java. The import-guided
// call resolver alone can't reach it (#34, failure mode #1); same-package resolution must.
class Service {
  int run(int x) {
    return Validator.check(x);
  }
}

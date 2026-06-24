package com.app;

// Wildcard import of the whole `com.lib` package — `Base` is NOT imported specifically, so the
// import-guided resolver can only reach it if it understands that `import com.lib.*` brings the
// package (its directory) into scope. (#34 failure mode #2)
import com.lib.*;

class User extends Base {
  String who() {
    return "user";
  }
}

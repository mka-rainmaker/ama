package com.util;

public class Helper {
  // Two overloads of `format` — the cross-file baseline caller resolves to the FIRST definition
  // (first-wins in funcsByFile) rather than skipping, unlike the within-file ambiguous-null behaviour.
  public static String format(int x) { return String.valueOf(x); }
  public static String format(String s) { return s; }
}

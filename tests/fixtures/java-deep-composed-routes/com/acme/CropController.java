package com.acme;

import org.springframework.web.bind.annotation.GetMapping;

import com.acme.api.AliasPutMapping;
import com.acme.api.AutoJobPostMapping;
import com.acme.api.GeneralApi;

@GeneralApi
public class CropController {
  @AutoJobPostMapping(value = "/crop")
  public String crop() {
    return "crop";
  }

  @GetMapping("/status")
  public String status() {
    return "ok";
  }

  @AliasPutMapping(route = "/alias")
  public String alias() {
    return "alias";
  }
}

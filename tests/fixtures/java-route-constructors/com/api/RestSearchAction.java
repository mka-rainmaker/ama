package com.api;

import static org.example.rest.RestRequest.Method.GET;
import static org.example.rest.RestRequest.Method.POST;

import java.util.List;

public class RestSearchAction {
    private String controlGroup;

    public List<Route> routes() {
        return List.of(
            new Route(GET, "/_search"),
            new Route(POST, "/_search"),
            new Route(RestRequest.Method.GET, "/{index}/_search")
        );
    }

    public List<String> readCgroupStats() {
        return PathUtils.get("/sys/fs/cgroup", controlGroup, "cpu.stat");
    }
}

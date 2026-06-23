package com.api;

import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.DELETE;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;

@Path("/books")
public class BookResource {

    @GET
    public String list() {
        return null;
    }

    @GET
    @Path("/{id}")
    public String get(@PathParam("id") Long id) {
        return null;
    }

    @POST
    public String create(String body) {
        return null;
    }

    @DELETE
    @Path("/{id}")
    public void remove(@PathParam("id") Long id) {
    }
}

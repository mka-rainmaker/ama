use actix_web::{get, post, web, HttpResponse};

#[get("/users")]
async fn list_users() -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[get("/users/{id}")]
async fn get_user(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[post("/users")]
async fn create_user() -> HttpResponse {
    HttpResponse::Ok().finish()
}

fn helper() -> u32 {
    1
}

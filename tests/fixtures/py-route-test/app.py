from fastapi import FastAPI

app = FastAPI()


@app.get("/users/{id}")
def get_user(id):
    return {}


@app.post("/reports")
def create_report():
    return {}

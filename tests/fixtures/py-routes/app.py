from flask import Flask

app = Flask(__name__)


@app.route("/users")
def list_users():
    return []


@app.route("/users/<int:id>")
def get_user(id):
    return {}


@app.get("/health")
def health():
    return "ok"


@app.post("/items/{item_id}")
def create_item(item_id):
    return {}


def not_a_route():
    return 1

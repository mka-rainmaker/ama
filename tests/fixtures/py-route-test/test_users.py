from fastapi.testclient import TestClient

from .app import app

client = TestClient(app)


def test_get_user():
    r = client.get("/users/1")
    assert r.status_code == 200


def test_create_report():
    r = client.post("/reports", json={"title": "x"})
    assert r.status_code == 200

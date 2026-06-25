"""Notes API — a tiny Flask + SQLite backend for the ovid sample.

Run the server:   flask --app app run -p 3001
CLI (terminal):   flask --app app notes add "Buy milk"
                  flask --app app notes list
"""

import re
import sqlite3
from pathlib import Path

import click
from flask import Flask, jsonify, request
from flask_cors import CORS

DB_PATH = Path(__file__).parent / "notes.db"


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5("
            "body, content='notes', content_rowid='id')"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN "
            "INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body); "
            "END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN "
            "INSERT INTO notes_fts(notes_fts, rowid, body) "
            "VALUES('delete', old.id, old.body); "
            "END"
        )
        conn.execute(
            "CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN "
            "INSERT INTO notes_fts(notes_fts, rowid, body) "
            "VALUES('delete', old.id, old.body); "
            "INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body); "
            "END"
        )
        conn.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')")


def fts_query(query: str) -> str:
    terms = re.findall(r"[\w]+", query)
    return " ".join(f'"{term}"*' for term in terms)


def search_notes(query: str) -> list[sqlite3.Row]:
    match = fts_query(query)
    if not match:
        return []
    with db() as conn:
        return conn.execute(
            "SELECT notes.id, notes.body "
            "FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid "
            "WHERE notes_fts MATCH ? "
            "ORDER BY bm25(notes_fts), notes.id",
            (match,),
        ).fetchall()


app = Flask(__name__)
CORS(app)  # sample runs the web UI on :3000 and the API on :3001
init_db()


@app.get("/notes")
def list_notes():
    with db() as conn:
        rows = conn.execute("SELECT id, body FROM notes ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/notes/search")
def search_notes_endpoint():
    query = (request.args.get("q") or "").strip()
    rows = search_notes(query)
    return jsonify([dict(r) for r in rows])


@app.post("/notes")
def add_note():
    body = ((request.get_json(silent=True) or {}).get("body") or "").strip()
    if not body:
        return jsonify({"error": "body required"}), 400
    with db() as conn:
        cur = conn.execute("INSERT INTO notes (body) VALUES (?)", (body,))
        note_id = cur.lastrowid
    return jsonify({"id": note_id, "body": body}), 201


# --- Flask CLI: `flask --app app notes <add|list>` (powers cli.spec.ts) ---

notes_cli = click.Group("notes", help="Manage notes from the terminal.")


@notes_cli.command("add")
@click.argument("body")
def notes_add(body: str) -> None:
    with db() as conn:
        cur = conn.execute("INSERT INTO notes (body) VALUES (?)", (body,))
    click.echo(f"Added #{cur.lastrowid}: {body}")


def echo_notes(rows: list[sqlite3.Row], empty_message: str) -> None:
    if not rows:
        click.echo(empty_message)
        return
    for r in rows:
        click.echo(f"#{r['id']}  {r['body']}")


@notes_cli.command("list")
def notes_list() -> None:
    with db() as conn:
        rows = conn.execute("SELECT id, body FROM notes ORDER BY id").fetchall()
    echo_notes(rows, "(no notes yet)")


@notes_cli.command("search")
@click.argument("query")
def notes_search(query: str) -> None:
    rows = search_notes(query)
    echo_notes(rows, "(no matching notes)")


app.cli.add_command(notes_cli)

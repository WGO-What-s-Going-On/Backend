#!/usr/bin/env bash
set -euo pipefail

mongo_uri='mongodb://mongo:27017/?directConnection=true'

mongosh "$mongo_uri" --quiet --eval '
  try {
    void rs.status();
  } catch (error) {
    if (error.codeName !== "NotYetInitialized") throw error;
    void rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] });
  }
'

until mongosh "$mongo_uri" --quiet --eval '
  if (!db.hello().isWritablePrimary) quit(1);
'; do
  sleep 1
done

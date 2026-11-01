// The localhost exception only exists before the first user. Never delete users on retries.
const fs = require('fs');
const rootPassword = fs
  .readFileSync('/credentials/mongodb-root-password', 'utf8')
  .trim();
const postPassword = fs
  .readFileSync('/credentials/mongodb-post-password', 'utf8')
  .trim();
const admin = db.getSiblingDB('admin');
let authenticated = false;
try {
  authenticated = admin.auth('root', rootPassword).ok === 1;
} catch {}
if (!authenticated && !db.hello().setName)
  rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'mongodb-0.mongodb:27017' }],
  });
let primary = false;
for (let attempt = 0; attempt < 120; attempt++) {
  if (db.hello().isWritablePrimary) {
    primary = true;
    break;
  }
  sleep(1000);
}
if (!primary) throw new Error('Mongo replica set did not elect a primary');
if (!authenticated) {
  admin.createUser({ user: 'root', pwd: rootPassword, roles: ['root'] });
  admin.auth('root', rootPassword);
}
const post = db.getSiblingDB('wgo_post');
if (!post.getUser('wgo_post'))
  post.createUser({
    user: 'wgo_post',
    pwd: postPassword,
    roles: [{ role: 'readWrite', db: 'wgo_post' }],
  });
if (post.auth('wgo_post', postPassword).ok !== 1)
  throw new Error('Mongo application credential mismatch');

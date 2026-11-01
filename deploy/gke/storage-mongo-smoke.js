const fs = require('fs');
const post = db.getSiblingDB('wgo_post');
post.auth(
  'wgo_post',
  fs.readFileSync('/credentials/mongodb-post-password', 'utf8').trim(),
);
const id = `storage-probe-${Date.now()}`;
post.gcp_storage_probe.insertOne({ _id: id, value: 1 });
const session = post.getMongo().startSession();
let active = false;
try {
  session.startTransaction();
  active = true;
  session
    .getDatabase('wgo_post')
    .gcp_storage_probe.updateOne({ _id: id }, { $set: { value: 2 } });
  session.abortTransaction();
  active = false;
  if (post.gcp_storage_probe.findOne({ _id: id }).value !== 1)
    throw new Error('Transaction rollback failed');
  session.startTransaction();
  active = true;
  session
    .getDatabase('wgo_post')
    .gcp_storage_probe.updateOne({ _id: id }, { $set: { value: 3 } });
  session.commitTransaction();
  active = false;
  if (post.gcp_storage_probe.findOne({ _id: id }).value !== 3)
    throw new Error('Transaction commit failed');
  print('Mongo TLS authentication and transaction commit/rollback passed');
} finally {
  if (active) session.abortTransaction();
  session.endSession();
  post.gcp_storage_probe.deleteOne({ _id: id });
}

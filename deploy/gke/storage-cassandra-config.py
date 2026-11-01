import pathlib
import re

path = pathlib.Path('/etc/cassandra/cassandra.yaml')
text = path.read_text()
for key, value in [('authenticator', 'PasswordAuthenticator'), ('authorizer', 'CassandraAuthorizer')]:
    text, count = re.subn(r'^' + key + r':.*$', key + ': ' + value, text, flags=re.M)
    if count != 1:
        raise RuntimeError('Unexpected Cassandra configuration')
password = pathlib.Path('/credentials/cassandra-keystore-password').read_text().strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{24,}', password):
    raise RuntimeError('Invalid keystore password format')
block = f'''client_encryption_options:
    enabled: true
    optional: false
    keystore: /tls/cassandra.jks
    keystore_password: {password}
    require_client_auth: false
    truststore: /tls/cassandra.jks
    truststore_password: {password}
'''
text, count = re.subn(r'^client_encryption_options:\n.*?(?=^[a-zA-Z_][a-zA-Z_0-9]*:|\Z)', block, text, flags=re.M | re.S)
if count != 1:
    raise RuntimeError('Unexpected Cassandra TLS configuration')
path.write_text(text)

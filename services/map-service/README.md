# WGO Map Service

Map Service owns the latest user location. `PUT /api/v1/location` accepts `{ "latitude": 37.5, "longitude": 127 }` with `X-User-Id` in local and test environments. Production returns 503 until Gateway user authentication is integrated. Cassandra is the source of truth; Redis caches each location for at most five minutes.

The location endpoint returns 200 with `latitude`, `longitude`, and server assigned `updatedAt`; invalid input returns 400, missing local identity 403, and unavailable storage 503.

`MapAuthorization.CheckPostCreation` and `CheckPostParticipation` are read-only gRPC calls on port 50051. They require an HS256 service JWT in `authorization: Bearer ...` with issuer `wgo-post-service`, audience `wgo-map-service`, subject `post-service`, and a lifetime of at most 60 seconds. Decisions return `allowed` and `reason` (`LOCATION_MISSING`, `LOCATION_STALE`, `OUTSIDE_RADIUS`). Checks use a location updated within five minutes and exact great-circle distance. Participation uses the post center and radius supplied by Post Service; the post ID is validated but Map does not store post data in this phase. PostCreated remains the event used for later spatial indexing.

Start local stores with `docker compose up -d`, wait for Cassandra's health check, then apply `docker cp schema.cql map-service-cassandra-1:/tmp/schema.cql` and `docker compose exec -T cassandra cqlsh -f /tmp/schema.cql`. Set variables from `.env.example` and run `pnpm dev`. `pnpm test`, `pnpm typecheck`, and `pnpm build` verify the service.

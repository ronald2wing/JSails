// The local services a framework checkout develops against: `jamal up` starts
// this MariaDB and Valkey pair with the credentials in `.env`.
export default {
  service: 'jsails-dev',
  image: 'jsails-dev:local',
  services: {
    db: { type: 'mariadb' },
    valkey: { type: 'valkey' },
  },
  local: {
    ports: { db: 3306, valkey: 6379 },
  },
};

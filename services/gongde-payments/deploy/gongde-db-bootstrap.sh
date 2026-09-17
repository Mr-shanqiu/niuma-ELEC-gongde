#!/bin/sh
set -eu

root_password="$(cat /run/secrets/mysql_root_password)"
app_password="$(cat /run/secrets/gongde_mysql_app_password)"
migrator_password="$(cat /run/secrets/gongde_mysql_migrator_password)"
for value in "$app_password" "$migrator_password"; do
  case "$value" in *[!A-Fa-f0-9]*|'') echo "invalid generated database password" >&2; exit 78 ;; esac
  [ "${#value}" -eq 64 ] || { echo "invalid generated database password" >&2; exit 78; }
done
umask 077
cat > /tmp/root.cnf <<EOF
[client]
host=zqscreen-mysql-1
user=root
password=$root_password
ssl-mode=REQUIRED
EOF
mysql --defaults-extra-file=/tmp/root.cnf <<EOF
CREATE DATABASE IF NOT EXISTS \`gongde\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'gongde_app'@'%' IDENTIFIED BY '$app_password';
ALTER USER 'gongde_app'@'%' IDENTIFIED BY '$app_password';
CREATE USER IF NOT EXISTS 'gongde_migrator'@'%' IDENTIFIED BY '$migrator_password';
ALTER USER 'gongde_migrator'@'%' IDENTIFIED BY '$migrator_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`gongde\`.* TO 'gongde_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ON \`gongde\`.* TO 'gongde_migrator'@'%';
FLUSH PRIVILEGES;
EOF

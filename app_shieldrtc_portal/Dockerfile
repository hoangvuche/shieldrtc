FROM php:8.2-apache

ARG APP_DIR=/var/www/html

# Sys packages + PHP extensions
RUN apt-get update && apt-get install -y \
      libzip-dev libicu-dev libpng-dev libjpeg-dev libfreetype6-dev \
      git unzip cron supervisor \
  && docker-php-ext-configure gd --with-freetype --with-jpeg \
  && docker-php-ext-install -j"$(nproc)" pdo_mysql intl gd zip bcmath sockets opcache \
  && a2enmod rewrite headers proxy proxy_wstunnel deflate expires \
  && rm -rf /var/lib/apt/lists/*

# PHP config
COPY config/php.ini                   /usr/local/etc/php/php.ini
COPY config/opcache.ini               /usr/local/etc/php/conf.d/opcache.ini
COPY config/timezone.ini              /usr/local/etc/php/conf.d/timezone.ini

# Apache config
COPY apache/vhost.conf                /etc/apache2/sites-available/000-default.conf
COPY apache/security-global.conf      /etc/apache2/conf-available/security-global.conf
RUN a2enconf security-global
COPY apache/headers-portal.conf       /etc/apache2/conf-available/headers-portal.conf

# App code
WORKDIR ${APP_DIR}
COPY html/ ${APP_DIR}/

# Runtime helpers
COPY cron/ /app/cron/
COPY logrotate/ /app/logrotate/
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /var/log/supervisor

EXPOSE 80
CMD ["/start.sh"]

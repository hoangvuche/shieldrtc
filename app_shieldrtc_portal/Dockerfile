FROM php:8.2-apache

RUN apt-get update && apt-get install -y git unzip libzip-dev         && docker-php-ext-install zip

# Enable Apache mods
RUN a2enmod rewrite headers

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www
RUN mkdir -p /var/www/html /var/www/storage/logs && chown -R www-data:www-data /var/www

COPY html/ /var/www/html/

# Set DocumentRoot
RUN sed -i 's#DocumentRoot /var/www/html#DocumentRoot /var/www/html#' /etc/apache2/sites-available/000-default.conf
RUN sed -i '/DocumentRoot/a <Directory /var/www/html>\nAllowOverride All\nRequire all granted\n</Directory>' /etc/apache2/sites-available/000-default.conf

# Generated by Django 4.2 on 2023-04-25 17:27

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('shop', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='shopitem',
            name='item_image',
            field=models.ImageField(blank=True, null=True, upload_to='shop-images'),
        ),
    ]
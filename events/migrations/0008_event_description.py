# Generated by Django 4.2 on 2023-04-15 21:55

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('events', '0007_eventday_day_flyer'),
    ]

    operations = [
        migrations.AddField(
            model_name='event',
            name='description',
            field=models.TextField(blank=True, max_length=2000, null=True),
        ),
    ]
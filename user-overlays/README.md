# User overlays

Put your own custom overlay HTML, images, CSS, JavaScript, and other personal files in this folder.

Files in this folder are served at:

```text
http://127.0.0.1:4318/user-overlays/your-file.html
```

Example:

```text
user-overlays/my-overlay.html
```

opens at:

```text
http://127.0.0.1:4318/user-overlays/my-overlay.html
```

Normal updates do not touch files in this folder. A full reinstall that deletes the whole project folder will still delete it, so back this folder up before reinstalling.

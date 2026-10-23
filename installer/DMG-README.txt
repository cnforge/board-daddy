Board Daddy
===========
1. Drag "Board Daddy" onto the Applications folder.
2. Open it once. macOS will block it the first time (the app is not notarized by Apple):
   - macOS 15 Sequoia and newer: go to System Settings > Privacy & Security,
     scroll down and click "Open Anyway" next to Board Daddy, then confirm.
   - macOS 14 and older: right-click "Board Daddy" in Applications, choose Open, then Open.
3. On first launch it downloads its engine (about 110 MB, once). Needs internet.

If macOS says the app is "damaged", run this in Terminal, then open it again:
   xattr -cr "/Applications/Board Daddy.app"

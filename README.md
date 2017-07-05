# RCTWebRTCSipDemo
Demo for https://github.com/oney/react-native-webrtc + https://github.com/zhengsjhs/SIP.js
## Usage
- Clone the repository, run `npm install`.  
- For iOS, run the project on Xcode.  
- For Android, run `react-native run-android` in the directory.  

You can run the app in Device/Simulator, or open https://www.roam-tech.com/verto.   
Enter the peer extension(test account 1000~1019, password 1234) in two devices or browers, the audio stream will be connected.

## NOTE
- Don't run it on iOS simulator, or change to `navigator.getUserMedia({"audio": true, "video": false})` to test audio only.

# 📄 User Flow: FoodWise AI Kullanıcı Akışı

Bu doküman, bir üniversite öğrencisinin uygulamayı açtığı andan itibaren yaşadığı deneyimi adım adım açıklar.

### 1. Giriş ve Tempo Seçimi
- **Adım:** Kullanıcı uygulamayı açar.
- **Eylem:** Mevcut akademik durumunu seçer: "Vize/Final Haftası (Yoğun)" veya "Normal Hafta (Standart)".
- **Sonuç:** AI, tüm öneri algoritmasını bu tempoya göre ayarlar.

### 2. Envanter Yönetimi
- **Adım:** Kullanıcı buzdolabındaki veya rafındaki ürünleri ekler.
- **Eylem:** Ürün adını ve yaklaşık bozulma süresini girer (Örn: Süt - 2 gün).
- **Sonuç:** Ürünler, bozulma riskine göre (Kırmızı/Sarı/Yeşil) listelenir.

### 3. Akıllı Bildirim ve Öneri
- **Adım:** Sistem, son kullanma tarihi yaklaşan ürünler için uyarı verir.
- **Eylem:** Kullanıcı "Kurtarıcı Tarif Üret" butonuna tıklar.
- **Sonuç:** Gemini AI, eldeki malzemeleri ve seçili akademik tempoyu birleştirerek 10 dakikalık bir tarif sunar.

### 4. Market Alışveriş Planı
- **Adım:** Kullanıcı eksikleri görmek ister.
- **Eylem:** "Akıllı Liste Oluştur" butonuna basar.
- **Sonuç:** AI, evdeki eksikleri ve kullanıcının seçtiği haftalık tempoyu analiz ederek optimize bir alışveriş listesi çıkarır.

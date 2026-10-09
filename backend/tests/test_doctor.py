from scripts import doctor


def test_doctor_runs_and_reports_each_check(capsys, monkeypatch):
    monkeypatch.setattr("sys.argv", ["doctor", "--port", "1"])
    doctor.results.clear()
    code = doctor.main()
    out = capsys.readouterr().out
    for name in ["Python", "Thư viện Python", "ffmpeg", "Database", "Model hoà âm", "Cổng 1"]:
        assert name in out
    assert code in (0, 1)
